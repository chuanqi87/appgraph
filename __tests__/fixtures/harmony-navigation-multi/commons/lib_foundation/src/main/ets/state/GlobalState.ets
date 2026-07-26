export enum AppStorageMap {
  CURRENT_CITY = 'currentCity',
}

@ObservedV2
export class GlobalState {
  @Trace public activeTabId: string = '';
  @Trace public isLoggedIn: boolean = false;
  private internalCounter: number = 0;
}

@ObservedV2
export class CurrentCity {
  @Trace public cityName: string = '';
}

/** 未被 connect 的普通类 —— 不应产出 DataModel。 */
export class PlainHelper {
  static format(v: string): string { return v; }
}
