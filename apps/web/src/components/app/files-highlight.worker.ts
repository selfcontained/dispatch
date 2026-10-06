import { highlightFile } from "./files-highlight";

self.onmessage = (event: MessageEvent<{ text: string; fileName: string }>) => {
  self.postMessage(highlightFile(event.data.text, event.data.fileName));
};
