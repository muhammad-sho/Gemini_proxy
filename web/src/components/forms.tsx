export function SecretReveal({ secret }: { secret: string }) {
  return (
    <div className="secret-reveal">
      <code>{secret}</code>
      <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(secret)}>
        Copy
      </button>
    </div>
  );
}
