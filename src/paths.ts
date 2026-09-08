// A deployment base keeps card art separate from SECTOR's root-level assets.
export const basePath = import.meta.env?.BASE_URL || "/";
export const assetUrl = (path: string) => basePath + path.replace(/^\/+/, "");
