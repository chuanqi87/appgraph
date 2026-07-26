import { AppStorageV2, PersistenceV2 } from '@kit.ArkUI';
import { GlobalState, CurrentCity, AppStorageMap } from 'lib_foundation';

export class StateWiring {
  // 2 参形式：key 默认取类型名
  globalState: GlobalState = AppStorageV2.connect(GlobalState, () => new GlobalState())!;

  // 3 参 + 常量 key：需要枚举回溯
  city: CurrentCity = PersistenceV2.connect(CurrentCity, AppStorageMap.CURRENT_CITY, () => new CurrentCity())!;

  // 类型未定义为 @ObservedV2 —— 必须零节点 + 告警
  unknown: object = AppStorageV2.connect(NotObservedModel, () => ({}))!;
}
