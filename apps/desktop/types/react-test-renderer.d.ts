/**
 * Local declarations for react-test-renderer.
 *
 * WHY NOT @types/react-test-renderer: it is not in this workspace, and adding
 * it means a registry fetch. The renderer is already here (the React Native
 * preset depends on it), and this test needs three things from it:
 * create(), act(), and a handle with root/toJSON. So the surface is declared
 * exactly, rather than pulled in wholesale or cast to `any` at the call site
 * -- an `any` import would make the test unable to catch a typo in the very API
 * it is exercising.
 *
 * SCOPED TO THIS PACKAGE on purpose. tsconfig.json's include is narrow, so
 * nothing else in the repo sees this file, and packages/ui keeps its own jest
 * renderer setup untouched.
 */
declare module 'react-test-renderer' {
  export interface ReactTestInstance {
    readonly props: Record<string, unknown> & { children?: unknown };
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    findAllByProps(props: Record<string, unknown>, options?: { deep?: boolean }): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    readonly root: ReactTestInstance;
    toJSON(): unknown;
    unmount(): void;
    update(element: React.ReactElement): void;
  }

  export function create(element: React.ReactElement, options?: unknown): ReactTestRenderer;
  export function act(callback: () => void | Promise<void>): Promise<void> | void;
}
