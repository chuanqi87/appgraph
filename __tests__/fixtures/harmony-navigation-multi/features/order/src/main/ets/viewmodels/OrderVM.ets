import { RouterModule, RouterMap } from 'lib_foundation';

export enum OrderKind {
  Detail = 'detail',
  List = 'list',
}

export class OrderVM {
  private items: string[] = [];

  openDetail() {
    // 枚举回溯 + 跨模块
    RouterModule.push({ url: RouterMap.ORDER_DETAIL });
  }

  /**
   * 条件路由：两个分支都是真实目标，且条件里还有一个**非路由**枚举抢在前面。
   * 只取第一个候选 token 会拿到 OrderKind.Detail（不在注册表）→ 整个调用点零边。
   */
  openByKind(kind: OrderKind) {
    RouterModule.push({
      url: kind === OrderKind.Detail ? RouterMap.ORDER_DETAIL : RouterMap.ORDER_LIST,
    });
  }

  addItem(name: string) {
    // 数组内建方法：绝不能连到 RouterModule.push
    this.items.push(name);
  }

  dropItem() {
    this.items.pop();
  }
}
