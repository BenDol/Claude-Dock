/**
 * Whitelist-based SVG sanitizer for runtime plugin toolbar icons.
 *
 * Only allows known-safe SVG elements and presentation attributes.
 * Strips scripts, event handlers, foreignObject, external references,
 * javascript: URLs, and data: URIs that could execute code.
 */

const ALLOWED_ELEMENTS = new Set([
  'svg',
  // Shapes
  'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  // Containers / structure
  'g', 'defs', 'symbol', 'clippath', 'mask',
  // Gradients
  'lineargradient', 'radialgradient', 'stop',
  // Text (for icon labels)
  'text', 'tspan',
  // Metadata (harmless)
  'title', 'desc'
])

const ALLOWED_ATTRIBUTES = new Set([
  // Core / sizing
  'viewbox', 'xmlns', 'width', 'height', 'id', 'class',
  // Presentation — fill / stroke
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule',
  'opacity', 'color', 'display', 'visibility',
  // Transform
  'transform',
  // Geometry — paths
  'd',
  // Geometry — circles / ellipses
  'cx', 'cy', 'r', 'rx', 'ry',
  // Geometry — rects / lines / positions
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height',
  // Geometry — polygons
  'points', 'pathlength',
  // Gradient attributes
  'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy',
  // Clip / mask references (values checked separately)
  'clip-path', 'mask',
  // Text
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'dx', 'dy',
  'textlength', 'lengthadjust'
])

/** Patterns that indicate a dangerous attribute value */
const DANGEROUS_VALUE = /javascript\s*:|data\s*:\s*text\/html|data\s*:\s*image\/svg\+xml/i

/**
 * Sanitizes an SVG markup string, returning only safe content.
 * Returns an empty string if the input is not valid SVG.
 */
export function sanitizeSvg(svgString: string): string {
  if (!svgString || typeof svgString !== 'string') return ''

  const parser = new DOMParser()
  const doc = parser.parseFromString(svgString.trim(), 'image/svg+xml')

  // DOMParser puts a <parsererror> element if parsing failed
  if (doc.querySelector('parsererror')) return ''

  const svg = doc.documentElement
  if (svg.tagName.toLowerCase() !== 'svg') return ''

  sanitizeElement(svg)
  return new XMLSerializer().serializeToString(svg)
}

function sanitizeElement(el: Element): void {
  // Strip disallowed attributes from this element
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()

    // Event handlers (onclick, onload, onerror, etc.)
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name)
      continue
    }

    // xlink:href and href can reference external resources or javascript:
    if (name === 'href' || name === 'xlink:href') {
      el.removeAttribute(attr.name)
      continue
    }

    // style attribute can contain url(), expression(), etc.
    if (name === 'style') {
      el.removeAttribute(attr.name)
      continue
    }

    if (!ALLOWED_ATTRIBUTES.has(name)) {
      el.removeAttribute(attr.name)
      continue
    }

    // Check attribute values for dangerous URI schemes
    if (DANGEROUS_VALUE.test(attr.value)) {
      el.removeAttribute(attr.name)
    }
  }

  // Process children — remove disallowed elements, recurse into allowed ones
  for (const child of Array.from(el.children)) {
    if (!ALLOWED_ELEMENTS.has(child.tagName.toLowerCase())) {
      child.remove()
    } else {
      sanitizeElement(child)
    }
  }
}
