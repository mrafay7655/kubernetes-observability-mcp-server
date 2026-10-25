// Kubernetes DNS-1123 name validation (subdomain format, max 253 chars)
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9\-\.]{0,251}[a-z0-9])?$/;

export function validateK8sName(value: string, field: string): void {
  if (!value) return;
  if (!K8S_NAME_RE.test(value)) {
    throw new Error(
      `${field} must be lowercase alphanumeric with dashes/dots, max 253 chars (got: "${value}")`
    );
  }
}
