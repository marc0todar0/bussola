import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// The transaction list, one page at a time
// ---------------------------------------------------------------------------
// The list used to arrive whole -- every transaction of the period, "All"
// included -- and the page filtered, searched, sorted and totalled it in the
// browser. The API does all of that now (api/controllers/
// transactions_controller.js) and answers in pages of whole days, so this
// hook only keeps what has been loaded so far:
//
//   items        day groups [{ id: 'yyyymmdd', data }], or rows when flat
//   flat         true when sorted by amount (no days in that order)
//   nextCursor   null once the end is reached
//   totIn, totOut, count, facets   for the whole list, from the first page
//   loading      the first page is on its way (the list below may be stale)
//   loadingMore  a further page is on its way
//   loaded       at least one first page has arrived
//
// Any change of period, filter, search or sort starts again from the first
// page. The search text is debounced, so typing "coop" asks once rather than
// four times; clearing it applies at once.
//
// Out-of-order answers are thrown away. Every first-page load aborts the one
// before it and takes a new generation number, and an answer whose generation
// is no longer current is ignored even if it could not be aborted in time --
// pressing "next month" three times quickly must end on the third month, not
// on whichever response happened to arrive last.

const SEARCH_DEBOUNCE_MS = 250;

const EMPTY = {
  items: [],
  flat: false,
  nextCursor: null,
  totIn: 0,
  totOut: 0,
  count: 0,
  facets: { from: [], to: [] },
  loading: true,
  loadingMore: false,
  loaded: false,
  error: null,
};

export function useTransactionPages(fetchAuth, { from, to, type, fromId, toId, q, sort, dir }) {
  const [state, setState] = useState(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;

  // The search as the API sees it: the text the person typed, once they have
  // paused.
  const [search, setSearch] = useState(q || "");
  useEffect(() => {
    const text = q || "";
    if (text === search) return undefined;
    if (!text) {
      setSearch("");
      return undefined;
    }
    const timer = setTimeout(() => setSearch(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, search]);

  const generation = useRef(0);
  const controller = useRef(null);
  const moreInFlight = useRef(false);

  // Everything that selects the list, as a query string. It doubles as the
  // dependency that says "this is a different list now".
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (type) params.set("type", String(type));
  if (fromId) params.set("fromId", String(fromId));
  if (toId) params.set("toId", String(toId));
  if (search.trim()) params.set("q", search.trim());
  if (sort && sort !== "date") params.set("sort", sort);
  if (dir && dir !== "desc") params.set("dir", dir);
  const query = params.toString();

  const url = useCallback(
    (cursor) => {
      const p = new URLSearchParams(query);
      if (cursor) p.set("cursor", cursor);
      const s = p.toString();
      return `/transactions${s ? `?${s}` : ""}`;
    },
    [query],
  );

  const reload = useCallback(async () => {
    if (controller.current) controller.current.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const mine = ++generation.current;
    moreInFlight.current = false;
    setState((s) => ({ ...s, loading: true, loadingMore: false, error: null }));

    try {
      const response = await fetchAuth(url(null), { signal: ctrl.signal, cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (mine !== generation.current) return;
      if (!response.ok || !json) {
        setState((s) => ({ ...s, loading: false, error: (json && json.code) || "REQUEST_FAILED" }));
        return;
      }
      setState({
        items: Array.isArray(json.data) ? json.data : [],
        flat: Boolean(json.flat),
        nextCursor: json.nextCursor ?? null,
        totIn: json.totIn ?? 0,
        totOut: json.totOut ?? 0,
        count: json.count ?? 0,
        facets: json.facets || { from: [], to: [] },
        loading: false,
        loadingMore: false,
        loaded: true,
        error: null,
      });
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (mine !== generation.current) return;
      console.error(error);
      setState((s) => ({ ...s, loading: false, error: "NETWORK_ERROR" }));
    }
  }, [fetchAuth, url]);

  // The next page, appended. Pages are whole days, so a day never has to be
  // stitched together from two of them. It belongs to the generation it was
  // asked in: if the list changes while it is in flight, it is dropped.
  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (!current.nextCursor || current.loading || moreInFlight.current) return;
    moreInFlight.current = true;
    const mine = generation.current;
    const signal = controller.current ? controller.current.signal : undefined;
    setState((s) => ({ ...s, loadingMore: true }));

    try {
      const response = await fetchAuth(url(current.nextCursor), { signal, cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (mine !== generation.current) return;
      if (!response.ok || !json) {
        setState((s) => ({ ...s, loadingMore: false, error: (json && json.code) || "REQUEST_FAILED" }));
        return;
      }
      setState((s) => ({
        ...s,
        items: [...s.items, ...(Array.isArray(json.data) ? json.data : [])],
        nextCursor: json.nextCursor ?? null,
        loadingMore: false,
      }));
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (mine !== generation.current) return;
      console.error(error);
      setState((s) => ({ ...s, loadingMore: false, error: "NETWORK_ERROR" }));
    } finally {
      if (mine === generation.current) moreInFlight.current = false;
    }
  }, [fetchAuth, url]);

  // A different list: start again from its first page.
  useEffect(() => {
    reload();
  }, [reload]);

  // Nothing left in flight once the page is gone.
  useEffect(
    () => () => {
      generation.current += 1;
      if (controller.current) controller.current.abort();
    },
    [],
  );

  return { ...state, searchPending: (q || "") !== search, loadMore, reload };
}
