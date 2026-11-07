import React from 'react';
import { FileText, Image as ImageIcon, Folder, FileCode, ArrowRight, Copy, Download, Trash2, Cpu } from 'lucide-react';
import { DroppedFile } from '../../types';

interface FileDropWidgetProps {
  file: DroppedFile | null;
  onActionClick: (action: string) => void;
}

export const FileDropWidget: React.FC<FileDropWidgetProps> = ({ file, onActionClick }) => {
  if (!file) {
    return (
      <div className="flex items-center justify-center w-full h-full px-6 text-center text-neutral-300 text-xs gap-2">
        <div className="w-3 h-3 rounded-full bg-blue-500 animate-ping" />
        <span>Lepaskan berkas di sini (PDF, Gambar, Folder)...</span>
      </div>
    );
  }

  // Tentukan ikon & menu berdasarkan tipe file
  const renderActions = () => {
    switch (file.type) {
      case 'pdf':
        return (
          <>
            <button onClick={() => onActionClick('Convert to Word')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 text-xs transition-colors">
              <FileText size={12} /> Convert to Word
            </button>
            <button onClick={() => onActionClick('Export to PNG')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs transition-colors">
              <Download size={12} /> Export PNG
            </button>
          </>
        );
      case 'image':
        return (
          <>
            <button onClick={() => onActionClick('Remove Background')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 text-xs transition-colors">
              <ImageIcon size={12} /> Remove BG
            </button>
            <button onClick={() => onActionClick('Convert to WebP')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs transition-colors">
              <ArrowRight size={12} /> To WebP
            </button>
          </>
        );
      case 'folder':
        return (
          <>
            <button onClick={() => onActionClick('Compress to .ZIP')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 text-xs transition-colors">
              <Folder size={12} /> Compress ZIP
            </button>
            <button onClick={() => onActionClick('Open in Terminal')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs transition-colors">
              <Cpu size={12} /> Terminal
            </button>
          </>
        );
      default:
        return (
          <>
            <button onClick={() => onActionClick('Copy Path')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs transition-colors">
              <Copy size={12} /> Copy Path
            </button>
            <button onClick={() => onActionClick('Delete')} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-600/30 hover:bg-red-600/50 text-red-200 text-xs transition-colors">
              <Trash2 size={12} /> Delete
            </button>
          </>
        );
    }
  };

  return (
    <div className="flex flex-col justify-center w-full h-full px-4 py-2 text-white">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="p-1.5 rounded-lg bg-blue-500/20 text-blue-400">
            {file.type === 'pdf' && <FileText size={16} />}
            {file.type === 'image' && <ImageIcon size={16} />}
            {file.type === 'folder' && <Folder size={16} />}
            {file.type === 'code' && <FileCode size={16} />}
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="text-xs font-semibold truncate text-white">{file.name}</span>
            <span className="text-[10px] text-neutral-400 uppercase">{file.extension} • {file.size}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {renderActions()}
      </div>
    </div>
  );
};