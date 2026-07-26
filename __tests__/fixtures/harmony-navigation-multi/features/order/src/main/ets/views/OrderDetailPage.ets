@Builder
export function buildOrderDetailPage() {
  OrderDetailPage()
}

@ComponentV2
export struct OrderDetailPage {
  build() {
    NavDestination() {
      Column() {
        Text('订单详情')
      }
    }
  }
}
