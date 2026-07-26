import { LoginUtils } from 'lib_foundation';

@Builder
export function SheetOnlyPageBuilder() {
  SheetOnlyPage()
}

@ComponentV2
export struct SheetOnlyPage {
  // 返回类型标注写法 —— M3 的回归场景
  build(): void {
    NavDestination() {
      Column() {
        Button('打开弹窗').onClick(() => {
          LoginUtils.openSheet();
        })
      }
    }
  }
}
