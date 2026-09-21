/**
 * Discovery-only in manifest v0.1.0: this detector reports that the capability
 * exists so the user can see it, but GRAFT cannot yet harvest it. Reporting a
 * capability as harvestable before an emitter exists would be a lie the user
 * only discovers at transplant time.
 */
export function detect(fp) {
  const routes = fp.routes.filter((r) => /\/(uploads?|files?|attachments?|media)\b/i.test(r.path));
  const storageEvidence = fp.files.filter((f) => /(multer|busboy|s3|@aws-sdk|formidable|UPLOAD_DIR)/i.test(fp.readFile(f) || ''));
  if (!routes.length) return { category: 'file-uploads', found: false, signals: [] };
  return {
    category: 'file-uploads',
    found: true,
    confidence: routes.length >= 2 ? 'medium' : 'low',
    signals: [
      { id: 'upload-routes', evidence: routes.map((r) => `${r.method} ${r.path}`).join(', ') },
      ...(storageEvidence.length ? [{ id: 'storage-config', evidence: storageEvidence.join(', ') }] : []),
    ],
    routes,
    contributingFiles: [...new Set(routes.map((r) => r.file))],
  };
}

export const meta = {
  category: 'file-uploads',
  // These detectors require HTTP routes, so what they find is a service by construction.
  implementationForm: 'service',
  displayName: 'File uploads',
  harvestable: false,
  notHarvestableReason: 'no transplant emitter exists for this category yet',
  describe(result) { return `${result.routes.length} upload endpoints`; },
};
