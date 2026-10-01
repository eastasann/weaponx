import { Component, type ReactNode } from "react";
import { reportClientError } from "../../lib/api";
import { ErrorPage } from "./ErrorPage";

type Props = { children: ReactNode };
type State = { failed: boolean };

/** ルーターの外(プロバイダーや根の描画)で起きた想定外のエラーを受ける最後の砦 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    void reportClientError(error);
  }

  render() {
    return this.state.failed ? <ErrorPage kind="unexpected" /> : this.props.children;
  }
}
