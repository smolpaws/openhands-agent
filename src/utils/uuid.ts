/** Normalize the UUID string forms accepted by the pinned Python boundary. */
export function normalizeUuid(value: string): string {
  let hex = value;
  if (hex.startsWith('urn:uuid:')) hex = hex.slice(9);
  if (hex.startsWith('{') && hex.endsWith('}')) hex = hex.slice(1, -1);
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(hex)) {
    throw new Error('Expected a valid UUID');
  }
  hex = hex.replaceAll('-', '');
  hex = hex.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
