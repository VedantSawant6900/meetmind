"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function FormattedChatText({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
