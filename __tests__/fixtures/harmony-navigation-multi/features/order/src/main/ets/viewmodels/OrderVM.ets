import { RouterModule, RouterMap } from 'lib_foundation';

export class OrderVM {
  private items: string[] = [];

  openDetail() {
    // 枚举回溯 + 跨模块
    RouterModule.push({ url: RouterMap.ORDER_DETAIL });
  }

  addItem(name: string) {
    // 数组内建方法：绝不能连到 RouterModule.push
    this.items.push(name);
  }

  dropItem() {
    this.items.pop();
  }
}
