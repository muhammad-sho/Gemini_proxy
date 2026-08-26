import { useState } from "react";

export function SecretReveal({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(secret).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false)
    );
  };

  return (
    <div className="secret-reveal">
      <code>{secret}</code>
      <button className="btn btn-ghost" onClick={copy} aria-live="polite">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
