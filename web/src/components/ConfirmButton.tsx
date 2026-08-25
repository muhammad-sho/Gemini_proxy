import { useState, type ReactNode } from "react";
import { useApp } from "../auth/useAuth.js";

export function ConfirmButton({
  prompt,
  warning,
  onConfirm,
  children,
  className = "btn btn-danger"
}: {
  /** Confirmation button label, e.g. "Yes, delete". */
  prompt: string;
  /** Consequence hint shown next to the confirmation. */
  warning?: string;
  onConfirm: () => Promise<void>;
  children?: ReactNode;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const { toast } = useApp();

  if (!armed) {
    return (
      <button className={className} onClick={() => setArmed(true)}>
        {children ?? "Delete"}
      </button>
    );
  }

  const confirm = async () => {
    try {
      await onConfirm();
    } catch (e) {
      toast("error", String((e as Error).message));
    } finally {
      setArmed(false);
    }
  };

  return (
    <span className="confirm-pair">
      <button
        className={className}
        title={warning}
        aria-label={warning ? `${prompt}. ${warning}` : prompt}
        onClick={confirm}
      >
        {prompt}
      </button>
      <button className="btn btn-ghost" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  );
}
