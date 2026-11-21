export function LoadError({ message }: { message: string }): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 p-4 text-sm text-rose-300"
    >
      <span>{message}</span>
      <button
        type="button"
        className="rounded-md border border-slate-700 px-3 py-1.5 text-slate-200 hover:bg-slate-800"
        onClick={() => window.location.reload()}
      >
        Try again
      </button>
    </div>
  );
}
