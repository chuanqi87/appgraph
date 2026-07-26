import { RouterModule } from 'lib_foundation';

export interface RouteInfo {
  url: string;
}

export class DynamicNav {
  go(info: RouteInfo) {
    // 运行期数据，静态不可解析 —— 必须丢弃，绝不猜
    RouterModule.push({ url: info.url });
  }
}
