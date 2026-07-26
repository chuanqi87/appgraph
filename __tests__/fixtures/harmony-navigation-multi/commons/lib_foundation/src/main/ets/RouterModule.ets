import { RouterMap } from './constants/RouterMap';
export interface NavRouterInfo {
  url: string;
  param?: Object;
}

/** 每个鸿蒙工程都有的导航单例封装。 */
export class RouterModule {
  public static stack: NavPathStack = new NavPathStack();

  public static getStack(): NavPathStack {
    return RouterModule.stack;
  }

  public static push(info: NavRouterInfo) {
    RouterModule.stack.pushPathByName(info.url, info.param);
  }

  public static pop(result?: Object) {
    RouterModule.stack.pop(result);
  }
}
