function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export function hasValidBearerToken(
  request: Request,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return false;
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return false;
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return false;
  }

  return constantTimeEqual(parts[1] ?? "", expectedToken);
}
