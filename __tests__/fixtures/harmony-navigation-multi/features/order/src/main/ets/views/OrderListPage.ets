import { OrderVM } from '../viewmodels/OrderVM';

@Builder
export function OrderListPageBuilder() {
  OrderListPage()
}

@ComponentV2
export struct OrderListPage {
  private vm: OrderVM = new OrderVM();

  build() {
    NavDestination() {
      Column() {
        Button('查看详情').onClick(() => {
          this.vm.openDetail();
        })
      }
    }
  }
}
