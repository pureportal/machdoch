export default function WorkspaceLoading() {
  return (
    <div className="cloud-skeleton" aria-busy="true" role="status">
      <span className="sr-only">Loading</span>
      <span className="cloud-skeleton-title" />
      <span className="cloud-skeleton-toolbar" />
      {Array.from({ length: 9 }, (_, index) => (
        <span className="cloud-skeleton-row" key={index} />
      ))}
    </div>
  );
}
