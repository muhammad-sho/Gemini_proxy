import { useState, type ReactNode } from "react";
import { useApp } from "../auth/useAuth.js";

export function ConfirmButton({
  prompt,
  onConfirm,
  children,
  className = "btn btn-danger"
}: {
  prompt: string;
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
      <button className={className} onClick={confirm}>{prompt}</button>
      <button className="btn btn-ghost" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  );
}
