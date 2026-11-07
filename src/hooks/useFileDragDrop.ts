/**
 * File: useFileDragDrop.ts
 * Kegunaan: Custom hook untuk menangkap event drag and drop file native dari Windows via Tauri API.
 */

import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DroppedFile } from "../types";

export const useFileDragDrop = () => {
  const [droppedFile, setDroppedFile] = useState<DroppedFile | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    async function setupDragDropListener() {
      try {
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              const filePath = paths[0];
              const fileName = filePath.split(/[/\\]/).pop() || "File";
              const ext = fileName.includes(".")
                ? fileName.split(".").pop()?.toUpperCase() || "FILE"
                : "DIR";

              let fileType: "pdf" | "image" | "folder" | "code" = "code";
              const lowerExt = ext.toLowerCase();

              if (lowerExt === "pdf") fileType = "pdf";
              else if (["png", "jpg", "jpeg", "webp", "gif"].includes(lowerExt))
                fileType = "image";
              else if (ext === "DIR") fileType = "folder";

              setDroppedFile({
                name: fileName,
                extension: ext,
                size: "Ready",
                path: filePath,
                type: fileType,
              });
            }
          }
        });
      } catch (e) {
        console.error("Gagal mendengarkan event drag and drop:", e);
      }
    }

    setupDragDropListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const clearFile = () => setDroppedFile(null);

  return { droppedFile, clearFile };
};
