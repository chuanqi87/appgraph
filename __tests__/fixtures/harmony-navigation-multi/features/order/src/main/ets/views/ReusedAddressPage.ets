// 从 lib_foundation 复用通用页面 —— 本文件不声明 struct
import { SharedAddressPage } from 'lib_foundation';

@Builder
export function buildReusedAddressPage() {
  SharedAddressPage()
}
