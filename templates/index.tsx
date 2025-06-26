import type { FC } from "hono/jsx";
import "hono/jsx";

const Layout: FC = (props) => {
  return (
    <html>
      <body>{props.children}</body>
    </html>
  );
};

const Index: FC<{}> = (_props: {}) => {
  return (
    <Layout>
      <h1>Hello Hono!</h1>
    </Layout>
  );
};

export default Index;
