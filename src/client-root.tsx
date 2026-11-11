'use client';
// What <Store.Root> in a Server Component renders: it hands the request's snapshot down by store name.
// The store's first hook below picks it up; later snapshots (client-side navigation) are merged in a
// layout effect, before components subscribe, so a new page's data isn't fetched again.
import { createElement, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { __SnapshotContext, __mergeSnapshot } from './createStore';

export function ClientRoot({ name, snapshot, children }: { name: string; snapshot: unknown; children?: ReactNode }) {
  const parent = useContext(__SnapshotContext);
  const value = useMemo(() => ({ ...(parent ?? {}), [name]: { snapshot } }), [parent, name, snapshot]);
  useLayoutEffect(() => {
    __mergeSnapshot(name, snapshot);
  }, [name, snapshot]);
  return createElement(__SnapshotContext.Provider, { value }, children);
}