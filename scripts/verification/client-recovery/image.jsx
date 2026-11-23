// Next's image optimization transport is outside these isolated layout checks.
export default function Image({ priority, unoptimized, ...props }) {
  return <img {...props} />
}
