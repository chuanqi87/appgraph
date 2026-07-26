import { RouterModule, RouterMap } from './RouterModule';

/**
 * 一个共享工具文件里放两个独立入口：一个跳转、一个不跳转。
 * 这是 B1 的回归场景 —— 归属回溯必须从「跳转函数」出发，
 * 而不是「该文件内任意符号」，否则 openSheet 的调用者也会被算成跳转来源。
 */
export class LoginUtils {
  /** 只开半模态弹窗，不跳转。 */
  public static openSheet(): void {
    console.log('open sheet');
  }

  /** 真跳转。 */
  public static jumpLoginPage(): void {
    RouterModule.push({ url: RouterMap.ORDER_LIST });
  }
}
