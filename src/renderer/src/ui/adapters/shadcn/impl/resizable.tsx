import type { ResizableApi } from '../../../contract/resizable';
import * as R from '../resizable';

export const ResizablePanelGroup: ResizableApi['ResizablePanelGroup'] = ({ direction, children }) => (
  <R.ResizablePanelGroup orientation={direction}>{children}</R.ResizablePanelGroup>
);
export const ResizablePanel: ResizableApi['ResizablePanel'] = ({ defaultSize, minSize, children }) => (
  <R.ResizablePanel
    defaultSize={defaultSize === undefined ? undefined : `${defaultSize}%`}
    minSize={minSize === undefined ? undefined : `${minSize}%`}
  >
    {children}
  </R.ResizablePanel>
);
export const ResizableHandle: ResizableApi['ResizableHandle'] = () => <R.ResizableHandle />;
