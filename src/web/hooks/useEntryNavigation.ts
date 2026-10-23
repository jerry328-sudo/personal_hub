import { useLocation, useNavigate } from "react-router-dom";

interface ReaderLocationState {
  feedReturnTo?: string;
}

// Keep the feed mounted while giving its reader a browser history entry.
export function useEntryNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const entryId = params.get("entry") || null;
  const state = location.state as ReaderLocationState | null;

  const openEntry = (id: string) => {
    if (id === entryId) return;
    const search = new URLSearchParams(location.search);
    search.set("entry", id);
    void navigate({ pathname: location.pathname, search: `?${search}`, hash: location.hash }, {
      // Switching records in the desktop split view should not stack readers.
      replace: entryId !== null,
      state: {
        ...state,
        feedReturnTo: entryId ? state?.feedReturnTo : `${location.pathname}${location.search}${location.hash}`,
      },
    });
  };

  const closeEntry = () => {
    if (!entryId) return;
    if (state?.feedReturnTo) {
      void navigate(-1);
      return;
    }
    // A directly opened reader has no in-app predecessor to return to.
    const search = new URLSearchParams(location.search);
    search.delete("entry");
    void navigate({ pathname: location.pathname, search: search.toString() ? `?${search}` : "", hash: location.hash }, {
      replace: true,
      state,
    });
  };

  return { entryId, reading: entryId !== null, openEntry, closeEntry };
}
