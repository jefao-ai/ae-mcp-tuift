// Environment variables of the TUIFT additions: TUIFT_<NAME>.

export function lerEnv(name: string): string | undefined {
  return process.env[`TUIFT_${name}`];
}
