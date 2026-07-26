import { RouterMap } from 'lib_foundation';

@Builder
export function HomePageBuilder() {
  HomePage()
}

@ComponentV2
export struct HomePage {
  build() {
    NavDestination() {
      Column() {
        Text('首页')
      }
    }
  }
}
