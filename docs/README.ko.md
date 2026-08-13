# Kotlin Continuous IntelliSense

공식 `Kotlin by JetBrains` 확장과 함께 사용하는 비공식 연속 입력
자동완성 패치입니다.

- Kotlin identifier 세 글자부터 10ms leading-edge 방식으로 네이티브 후보
  창을 요청합니다.
- 다음 글자가 들어와 LSP 요청이 취소돼도 진행 중인 semantic completion
  계산을 유지하고 더 긴 prefix가 재사용합니다.
- `@` 문맥에서는 Java short-class Stub 인덱스를 현재 PSI 파일의 resolve
  scope로 제한해 실제로 접근할 수 있는 annotation class와 import edit를
  함께 반환합니다.
- main 파일에서는 `implementation` 의존성의 어노테이션만 포함하고
  `testImplementation`이나 무관한 모듈의 어노테이션은 제외합니다.
- Spring 이름을 하드코딩하지 않습니다.

현재 지원 버전은 `jetbrains.kotlin-server@0.0.8 /
ILS-263.2689.0`으로 제한됩니다. 동반 VS Code 확장 버전은 `0.6.0`입니다.
전체 JetBrains 확장이나 서버 바이너리는
이 저장소에 포함하지 않습니다.

빌드, 설치, 복구, 테스트 방법은 루트 [README](../README.md)를
참고하세요.
