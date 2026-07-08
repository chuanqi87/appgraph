import router from '@ohos.router';

@Entry
@Component
struct MainPage {
  build() {
    Column() {
      Button('Profiles')
        .onClick(() => {
          router.pushUrl({ url: 'pages/ProfilesPage' });
        })
    }
  }
}
