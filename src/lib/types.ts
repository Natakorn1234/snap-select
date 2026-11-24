export type CullStatus = 'UNRATED' | 'KEEP' | 'MAYBE' | 'REJECT';

export const JPEG_EXT = ['jpg', 'jpeg'] as const;
export const PNG_EXT = ['png'] as const;
export const RAW_EXT = ['cr2', 'cr3', 'nef', 'arw', 'raf', 'dng'] as const;
export const SUPPORTED_EXT = new Set<string>([...JPEG_EXT, ...PNG_EXT, ...RAW_EXT]);

export type FileKind = 'jpeg' | 'png' | 'raw';

/** One physical file inside the selected folder (never in a subfolder). */
export interface PhotoFile {
  name: string;
  ext: string; // lower-case, no dot
  kind: FileKind;
  size: number;
  lastModified: number;
  handle: FileSystemFileHandle;
}

/** A culling unit: one shot = RAW and/or JPEG with the same base name. */
export interface PhotoGroup {
  id: string; // lower-cased base name (unique per folder)
  baseName: string;
  files: PhotoFile[];
  /** File used for thumbnails/preview (JPEG/PNG preferred, else RAW). */
  preview: PhotoFile;
}

export type StatusMap = Record<string, CullStatus>;
