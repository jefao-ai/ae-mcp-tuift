"""Beat and downbeat times of an audio file with beat_this (checkpoint final0).

The audio is decoded with ffmpeg (mono float32, 22.05 kHz) and handed to
Audio2Beats, so it works without torchaudio/soundfile backends.
Usage: python -I beats.py <audio> -> JSON {beats, downbeats, bpm, device} on stdout.
"""
import json
import subprocess
import sys

import numpy as np


def decode(path: str, sr: int = 22050) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def main() -> None:
    path = sys.argv[1]
    import torch
    from beat_this.inference import Audio2Beats

    device = "cuda" if torch.cuda.is_available() else "cpu"
    sr = 22050
    signal = decode(path, sr)
    a2b = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
    beats, downbeats = a2b(signal, sr)
    beats = [round(float(b), 4) for b in beats]
    downbeats = [round(float(b), 4) for b in downbeats]
    bpm = None
    if len(beats) > 2:
        gaps = sorted(b - a for a, b in zip(beats, beats[1:]))
        med = gaps[len(gaps) // 2]
        bpm = round(60.0 / med, 2) if med > 0 else None
    json.dump({"beats": beats, "downbeats": downbeats, "bpm": bpm, "device": device}, sys.stdout)


if __name__ == "__main__":
    main()
