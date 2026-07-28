# Kotlin Continuous IntelliSense

공식 `Kotlin by JetBrains` 확장과 함께 사용하는 비공식 연속 입력
자동완성 패치입니다.

- Kotlin identifier 세 글자부터 10ms leading-edge 방식으로 네이티브 후보
  창을 요청합니다.
- 다음 글자가 들어와 LSP 요청이 취소돼도 진행 중인 semantic completion
  계산을 유지하고 더 긴 prefix가 재사용합니다.
- `@` 문맥에서는 Gradle import 후 만들어진 프로젝트 인덱스에서 실제
  annotation class를 검색하고 import edit를 함께 반환합니다.
- Spring 이름을 하드코딩하지 않습니다.

현재 지원 버전은 `jetbrains.kotlin-server@0.0.6 /
LS-262.9593.0`으로 제한됩니다. 전체 JetBrains 확장이나 서버 바이너리는
이 저장소에 포함하지 않습니다.

빌드, 설치, 복구, 테스트 방법은 루트 [README](../README.md)를
참고하세요.
