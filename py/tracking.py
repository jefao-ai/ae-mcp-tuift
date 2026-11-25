"""Analyze local footage and return editable tracking data to the AE bridge."""
import itertools
import json
import sys

try:
    import av
    import cv2 as cv
    import numpy as np
except ImportError as exc:
    print(json.dumps({"ok": False, "error": f"Python de mídia precisa de PyAV, OpenCV e NumPy: {exc}"}))
    sys.exit(0)


def frames(job):
    """Sample source presentation timestamps without retaining the whole clip."""
    with av.open(job["file"]) as clip:
        stream = clip.streams.video[0]
        stream.codec_context.thread_count = 2
        time_base = float(stream.time_base)
        origin = (stream.start_time or 0) * time_base
        stamps = job["times"]
        if stamps[0] > 0.5:
            clip.seek(int((origin + stamps[0]) / time_base), stream=stream)
        width, height = job["width"], job["height"]
        shrink = min(1, 1280 / max(width, height))
        size = (round(width * shrink), round(height * shrink))
        target, image = 0, None
        for frame in clip.decode(stream):
            if frame.pts is None:
                continue
            stamp = float(frame.pts * stream.time_base) - origin
            if frame.width != width or frame.height != height:
                raise ValueError("As dimensões do vídeo decodificado diferem das interpretadas no After Effects.")
            while target < len(stamps) and stamps[target] < stamp - 1e-6:
                if image is None:
                    raise ValueError("O vídeo não contém o quadro inicial solicitado.")
                yield image
                target += 1
            if target == len(stamps):
                return
            image = frame.reformat(width=size[0], height=size[1], format="gray").to_ndarray()
        duration = stream.duration * time_base if stream.duration is not None else job["duration"]
        while image is not None and target < len(stamps) and stamps[target] < duration + 1e-6:
            yield image
            target += 1
        if target != len(stamps):
            raise ValueError("O vídeo termina antes do intervalo solicitado.")


def features(image, maximum, mask=None):
    found = cv.goodFeaturesToTrack(image, maximum, 0.006, 6, mask=mask, blockSize=5)
    if found is None:
        return np.empty((0, 2), dtype=np.float32)
    return found.reshape(-1, 2)


def flow(previous, image, points):
    params = dict(winSize=(25, 25), maxLevel=3)
    found, forward, _ = cv.calcOpticalFlowPyrLK(previous, image, points, None, **params)
    if found is None:
        return points, np.zeros(len(points), dtype=bool), np.full(len(points), np.inf)
    reverse, backward, _ = cv.calcOpticalFlowPyrLK(image, previous, found, None, **params)
    if reverse is None:
        return found, np.zeros(len(points), dtype=bool), np.full(len(points), np.inf)
    drift = np.linalg.norm(reverse - points, axis=1)
    height, width = image.shape
    valid = (
        (forward.ravel() > 0) & (backward.ravel() > 0) & (drift < 1.25)
        & (found[:, 0] >= 0) & (found[:, 0] < width)
        & (found[:, 1] >= 0) & (found[:, 1] < height)
    )
    return found, valid, drift


def polygon_mask(shape, vertices):
    mask = np.zeros(shape, dtype=np.uint8)
    polygon = np.rint(vertices).astype(np.int32)
    cv.fillPoly(mask, [polygon], 255)
    return mask


def analyze_point(job, current, remaining, scale):
    if job["center"] is None:
        margin = np.zeros(current.shape, np.uint8)
        margin[12:-12, 12:-12] = 255
        point = features(current, 1, margin)
        if len(point) == 0:
            raise ValueError("Não encontrei um ponto com textura suficiente no primeiro quadro.")
    else:
        point = np.asarray([job["center"]], np.float32) * scale
    height, width = current.shape
    if not (0 <= point[0, 0] < width and 0 <= point[0, 1] < height):
        raise ValueError("O ponto inicial está fora do vídeo.")
    positions = [(point[0] / scale).tolist()]
    scores = [1.0]
    previous = current
    for index, image in enumerate(remaining, 2):
        found, valid, error = flow(previous, image, point)
        if not valid[0]:
            raise ValueError(f"Perdi o ponto no quadro {index} do intervalo. Escolha um ponto mais contrastado ou encurte o trecho.")
        positions.append((found[0] / scale).tolist())
        scores.append(round(float(1 / (1 + error[0])), 4))
        point, previous = found, image
    return {"positions": positions, "confidence": scores}


def analyze_mask(job, current, remaining, scale):
    vertices = np.asarray(job["polygon"], np.float64) * scale
    if not np.isfinite(vertices).all() or np.max(np.abs(vertices)) > 1e6:
        raise ValueError("A máscara inicial tem coordenadas inválidas.")
    matrices = [np.eye(3)]
    inliers = []
    previous = current
    for index, image in enumerate(remaining, 2):
        points = features(previous, 140, polygon_mask(previous.shape, vertices))
        if len(points) < 6:
            raise ValueError(f"Pouca textura dentro da máscara no quadro {index-1} do intervalo.")
        found, valid, _ = flow(previous, image, points)
        if np.count_nonzero(valid) < 6:
            raise ValueError(f"Perdi a máscara no quadro {index} do intervalo.")
        step, good = cv.estimateAffinePartial2D(
            points[valid], found[valid], method=cv.RANSAC, ransacReprojThreshold=1.75,
        )
        count = int(np.count_nonzero(good)) if good is not None else 0
        if step is None or count < 6 or count < 0.55 * np.count_nonzero(valid):
            raise ValueError(f"O movimento da máscara ficou ambíguo no quadro {index} do intervalo.")
        matrices.append(np.vstack([step, [0, 0, 1]]) @ matrices[-1])
        vertices = vertices @ step[:, :2].T + step[:, 2]
        inliers.append(count)
        previous = image
    # Convert the affine matrices from decoder coordinates to original layer pixels.
    resize = np.diag([*scale, 1])
    inverse = np.diag([*(1 / scale), 1])
    return {
        "matrices": [(inverse @ matrix @ resize)[:2].tolist() for matrix in matrices],
        "minimumInliers": min(inliers),
    }


def camera_tracks(first, remaining):
    points = features(first, 1500)
    if len(points) < 24:
        raise ValueError("Poucas feições para reconstruir a câmera.")
    observations = [points.copy()]
    ids = np.arange(len(points))
    previous = first
    for image in remaining:
        found, valid, _ = flow(previous, image, points)
        points, ids, previous = found[valid], ids[valid], image
        measured = np.full_like(observations[0], np.nan)
        measured[ids] = points
        observations.append(measured)
        if len(points) < 16:
            raise ValueError("O enquadramento perdeu muitas referências. Use um trecho contínuo mais curto.")
    return np.asarray(observations)


def bootstrap(observations, intrinsics):
    last = len(observations) - 1
    best = None
    for index in sorted(set(last * j // 7 for j in range(2, 8)), reverse=True):
        use = np.flatnonzero(np.isfinite(observations[index, :, 0]))
        if len(use) < 20:
            continue
        origin, destination = observations[0, use], observations[index, use]
        _, planar = cv.findHomography(origin, destination, cv.RANSAC, 1.4)
        if planar is not None and np.count_nonzero(planar) >= 0.9 * len(use):
            continue
        matrix, inliers = cv.findEssentialMat(
            origin, destination, intrinsics, method=cv.RANSAC, prob=0.999, threshold=1.1,
        )
        if matrix is None or matrix.shape != (3, 3):
            continue
        count, rotation, translation, good = cv.recoverPose(
            matrix, origin, destination, intrinsics, mask=inliers,
        )
        if count < 16:
            continue
        use = use[good.ravel() > 0]
        origin, destination = observations[0, use], observations[index, use]
        # Compare rays in the same coordinate system to distinguish parallax from rotation.
        inverse = np.linalg.inv(intrinsics)
        ray0 = np.column_stack([origin, np.ones(len(use))]) @ inverse.T
        ray1 = np.column_stack([destination, np.ones(len(use))]) @ inverse.T @ rotation
        ray0 /= np.linalg.norm(ray0, axis=1)[:, None]
        ray1 /= np.linalg.norm(ray1, axis=1)[:, None]
        angles = np.degrees(np.arccos(np.clip(np.sum(ray0 * ray1, axis=1), -1, 1)))
        candidates = angles > 0.4
        score = np.count_nonzero(candidates) * min(float(np.median(angles)), 3)
        if np.count_nonzero(candidates) < 16 or (best is not None and score <= best[0]):
            continue
        projection0 = intrinsics @ np.eye(3, 4)
        projection1 = intrinsics @ np.column_stack([rotation, translation])
        xyz1 = cv.triangulatePoints(projection0, projection1, origin[candidates].T, destination[candidates].T).T
        xyz = xyz1[:, :3] / xyz1[:, 3:]
        good_xyz = np.isfinite(xyz).all(axis=1) & (xyz[:, 2] > 0)
        if np.count_nonzero(good_xyz) >= 16:
            best = (score, use[candidates][good_xyz], xyz[good_xyz])
    if best is None:
        raise ValueError("Não há paralaxe confiável para resolver a câmera. Use um trecho com deslocamento lateral e profundidades diferentes, ou ajuste horizontalFov.")
    return best[1], best[2]


def analyze_camera(job, first, remaining, scale):
    height, width = first.shape
    focal = width / (2 * np.tan(np.radians(job["fov"]) / 2))
    intrinsics = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1]])
    observations = camera_tracks(first, remaining)
    ids, landmarks = bootstrap(observations, intrinsics)
    zoom = float(focal / scale[0])
    world_scale = zoom / float(np.median(landmarks[:, 2]))
    origin = np.array([job["width"] / 2, job["height"] / 2, -zoom])
    poses, errors, counts = [], [], []
    down = np.array([0, 1, 0])
    previous_roll = 0
    for index, frame in enumerate(observations, 1):
        measured = frame[ids]
        use = np.isfinite(measured[:, 0])
        if np.count_nonzero(use) < 12:
            raise ValueError(f"Poucas referências 3D no quadro {index}.")
        xyz, pixels = landmarks[use], np.ascontiguousarray(measured[use])
        ok, rvec, tvec, inliers = cv.solvePnPRansac(
            xyz, pixels, intrinsics, None, iterationsCount=140, reprojectionError=2.5,
            confidence=0.998, flags=cv.SOLVEPNP_EPNP,
        )
        if not ok or inliers is None or len(inliers) < max(12, 0.65 * len(xyz)):
            raise ValueError(f"A pose da câmera no quadro {index} ficou ambígua.")
        keep = inliers.ravel()
        rvec, tvec = cv.solvePnPRefineLM(xyz[keep], pixels[keep], intrinsics, None, rvec, tvec)
        projected, _ = cv.projectPoints(xyz, rvec, tvec, intrinsics, None)
        errors.append(float(np.median(np.linalg.norm(projected.reshape(-1, 2) - pixels, axis=1))))
        counts.append(len(keep))
        rotation = cv.Rodrigues(rvec)[0]
        if np.any((xyz[keep] @ rotation.T + tvec.ravel())[:, 2] <= 0):
            raise ValueError(f"Pose 3D inválida no quadro {index}.")
        center = -rotation.T @ tvec.ravel()
        forward = rotation[2]
        right = np.cross(down, forward)
        length = np.linalg.norm(right)
        if length < 0.01:
            raise ValueError("A câmera ficou quase vertical. Divida esse movimento em outro trecho.")
        right /= length
        vertical = np.cross(forward, right)
        roll = np.degrees(np.arctan2(rotation[0] @ vertical, rotation[0] @ right))
        roll = previous_roll + (roll - previous_roll + 180) % 360 - 180
        previous_roll = roll
        position = origin + world_scale * center
        poses.append({"position": position.tolist(), "target": (position + zoom * forward).tolist(), "roll": float(roll)})
    if max(errors) > 2.2:
        raise ValueError("A reconstrução ficou imprecisa. Confira horizontalFov ou escolha um trecho mais curto.")
    return {
        "poses": poses,
        "zoom": zoom,
        "minimumInliers": min(counts),
        "medianReprojectionErrorPx": round(float(np.median(errors) / scale[0]), 3),
    }


def main():
    cv.setNumThreads(2)
    cv.setRNGSeed(12)
    with open(sys.argv[1], encoding="utf-8") as spec:
        job = json.load(spec)
    stream = frames(job)
    try:
        first = next(stream)
    except StopIteration:
        raise ValueError("Nenhum quadro foi decodificado.") from None
    scale = np.array([first.shape[1] / job["width"], first.shape[0] / job["height"]], np.float32)
    analyzers = {"point": analyze_point, "mask": analyze_mask, "camera": analyze_camera}
    data = analyzers[job["kind"]](job, first, stream, scale)
    return {"ok": True, **data}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), allow_nan=False))
    except (ValueError, OSError, cv.error, av.FFmpegError, np.linalg.LinAlgError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
