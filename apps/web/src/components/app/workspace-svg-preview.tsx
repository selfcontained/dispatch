import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilesTextPreview } from "./files-text-preview";

export function WorkspaceSvgPreview({
  preview,
  fileName,
}: {
  preview: { src: string; text: string };
  fileName: string;
}) {
  const [view, setView] = useState("preview");
  return (
    <Tabs
      value={view}
      onValueChange={setView}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList aria-label="SVG view" className="m-2 self-start shrink-0">
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
      </TabsList>
      <TabsContent
        value="preview"
        className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
          <img
            src={preview.src}
            alt={fileName}
            className="max-h-full w-full max-w-lg object-contain"
          />
        </div>
      </TabsContent>
      <TabsContent
        value="code"
        className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <FilesTextPreview text={preview.text} fileName={fileName} />
      </TabsContent>
    </Tabs>
  );
}
