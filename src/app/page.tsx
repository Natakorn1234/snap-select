'use client';
import { useState } from 'react';
import Home, { LoadedFolder } from '@/components/Home';
import Workspace from '@/components/Workspace';

export default function Page() {
  const [folder, setFolder] = useState<LoadedFolder | null>(null);
  if (!folder) return <Home onStart={setFolder} />;
  return <Workspace key={folder.sessionId} folder={folder} onExit={() => setFolder(null)} />;
}
