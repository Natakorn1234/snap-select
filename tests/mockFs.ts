/** Minimal in-memory File System Access API mock for tests. */
export class MockFile {
  constructor(public name: string, public size: number, public lastModified = 1000) {}
}
export class MockFileHandle {
  kind = 'file' as const;
  constructor(public dir: MockDir, public name: string, public id: object) {}
  async getFile() {
    if (this.dir.disconnected) throw new DOMException('gone', 'NotFoundError');
    const f = this.dir.files.get(this.name);
    if (!f || f.id !== this.id) throw new DOMException('gone', 'NotFoundError');
    return { size: f.file.size, lastModified: f.file.lastModified } as File;
  }
  async isSameEntry(other: MockFileHandle) { return other.id === this.id; }
  async remove() { await this.dir.removeEntry(this.name); }
}
export class MockDir {
  kind = 'directory' as const;
  files = new Map<string, { file: MockFile; id: object }>();
  disconnected = false;
  permission: PermissionState = 'prompt';
  grantOnRequest = true;
  failRemoveOn = new Set<string>();
  removed: string[] = [];
  constructor(public name: string, files: MockFile[]) {
    for (const f of files) this.files.set(f.name, { file: f, id: {} });
  }
  handle(name: string) { return new MockFileHandle(this, name, this.files.get(name)!.id); }
  async queryPermission() { return this.permission; }
  async requestPermission() { if (this.grantOnRequest) this.permission = 'granted'; else this.permission = 'denied'; return this.permission; }
  async *values() {
    if (this.disconnected) throw new DOMException('gone', 'NotFoundError');
    for (const name of this.files.keys()) yield this.handle(name);
  }
  async getFileHandle(name: string) {
    if (this.disconnected) throw new DOMException('gone', 'NotFoundError');
    if (!this.files.has(name)) throw new DOMException('nf', 'NotFoundError');
    return this.handle(name);
  }
  async removeEntry(name: string) {
    if (this.disconnected) throw new DOMException('gone', 'NotFoundError');
    if (this.failRemoveOn.has(name)) throw new DOMException('locked', 'NoModificationAllowedError');
    if (!this.files.delete(name)) throw new DOMException('nf', 'NotFoundError');
    this.removed.push(name);
  }
}
