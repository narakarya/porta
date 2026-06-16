export function isDockerRuntimeUnavailable(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("docker/orbstack is not running") ||
    lower.includes("docker desktop or orbstack") ||
    lower.includes("docker cli not found") ||
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("is the docker daemon running") ||
    lower.includes("error during connect")
  );
}
