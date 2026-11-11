// React, for createStore.ts. One file for every environment: Server Components, Client Components
// rendered on the server, and the browser. A namespace import, because React's Server Component
// build has no hooks or createContext (named imports of them would fail the build); there they're
// undefined, which is fine: createStore.ts doesn't call them in Server Components.
import * as React from 'react';
import { ClientRoot as ClientRootComponent } from './client-root';

const R = React as unknown as Record<string, unknown>;
export const RSC: boolean = typeof R.useState !== 'function'; // true only in Server Components
export const createContext = R.createContext as typeof React.createContext;
export const createElement = React.createElement;
export const useCallback = R.useCallback as typeof React.useCallback;
export const useContext = R.useContext as typeof React.useContext;
export const useEffect = R.useEffect as typeof React.useEffect;
export const useRef = R.useRef as typeof React.useRef;
export const useSyncExternalStore = R.useSyncExternalStore as typeof React.useSyncExternalStore;
export const cache = (RSC ? R.cache : undefined) as (<T extends (...args: never[]) => unknown>(fn: T) => T) | undefined;
export const ClientRoot: unknown = ClientRootComponent;
export type { ReactElement, ReactNode } from 'react';