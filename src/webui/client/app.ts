import { renderUnifiedGraph } from './unified-graph';

async function init(): Promise<void> {
  const appEl = document.getElementById('app');
  if (!appEl) return;
  await renderUnifiedGraph(appEl);
}

void init();
