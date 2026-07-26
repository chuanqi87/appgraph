import { RouterModule, RouterMap } from 'lib_foundation';

@Entry
@ComponentV2
struct Index {
  @Local selectIndex: number = 0;

  aboutToAppear() {
    RouterModule.getStack().clear();
  }

  build() {
    Navigation(RouterModule.getStack()) {
      Column() {
        Button('去订单列表').onClick(() => {
          // 枚举常量回溯：RouterMap.ORDER_LIST → 'OrderList' → 注册表
          RouterModule.push({ url: RouterMap.ORDER_LIST });
        })
      }
    }.mode(NavigationMode.Stack)
  }
}
