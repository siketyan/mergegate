// The light build (no Redis) is what the Octokit plugins load; it ships no types of its own.
declare module "bottleneck/light.js" {
  import Bottleneck from "bottleneck";
  export default Bottleneck;
}
