/**
 * The demo page — substantial enough that a reviewer can meaningfully pin
 * an element (a heading, a card, a button, the image) AND select text
 * inside a paragraph (the testimonial). Stable `id`/`data-testid`s are on
 * every pinnable element for a later Playwright suite (WP11) to target.
 */

const FEATURES = [
  {
    id: "anchoring",
    title: "Anchors that survive re-renders",
    body: "Every pin captures a selector, a text hint, an ancestor path, and geometry — so it can re-bind after a reload, a re-render, or a copy edit.",
  },
  {
    id: "storage",
    title: "You own the database",
    body: "The package ships no server and no database. This demo's ReviewStore is a normal Drizzle + Postgres implementation, nothing more.",
  },
  {
    id: "identity",
    title: "No reviewer accounts",
    body: "Reviewers unlock with a shared password and a browser-minted identity — there is no user table to provision.",
  },
];

export default function HomePage() {
  return (
    <main>
      <section className="demo-hero" id="hero" data-testid="hero">
        <h1 id="hero-heading" data-testid="hero-heading">
          @r3lab/web-review example
        </h1>
        <p id="hero-subheading" data-testid="hero-subheading">
          A minimal Next.js App Router app wiring the review overlay to a real Postgres database
          through <code>@r3lab/web-review/drizzle</code>. Pin any element on this page, or select
          a sentence in the testimonial below, and leave a comment.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- static demo asset, no next/image needed */}
        <img
          className="demo-hero-image"
          id="hero-image"
          data-testid="hero-image"
          src="/demo-hero.svg"
          alt="Abstract gradient illustration"
          width={960}
          height={320}
        />
      </section>

      <section className="demo-section" id="features" data-testid="features">
        <h2 id="features-heading" data-testid="features-heading">
          Features
        </h2>
        <div className="demo-feature-grid">
          {FEATURES.map((feature) => (
            <article
              key={feature.id}
              className="demo-feature-card"
              id={`feature-${feature.id}`}
              data-testid={`feature-${feature.id}`}
            >
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="demo-section" id="testimonial" data-testid="testimonial">
        <h2 id="testimonial-heading" data-testid="testimonial-heading">
          What reviewers say
        </h2>
        <blockquote className="demo-testimonial" id="testimonial-quote" data-testid="testimonial-quote">
          &ldquo;I dropped a pin on the pricing table, selected the word
          &lsquo;unlimited&rsquo; in the fine print, and had a thread open with the design
          team in under ten seconds. No account, no Slack thread, no screenshot pasted into a
          doc.&rdquo;
        </blockquote>
      </section>

      <section className="demo-section" id="cta" data-testid="cta">
        <h2 id="cta-heading" data-testid="cta-heading">
          Try it
        </h2>
        <p>
          Press <kbd>c</kbd> anywhere on this page, then click an element below to pin a comment
          to it.
        </p>
        <div className="demo-cta">
          <button
            type="button"
            className="demo-button demo-button--primary"
            id="cta-primary"
            data-testid="cta-primary"
          >
            Get started
          </button>
          <button
            type="button"
            className="demo-button demo-button--secondary"
            id="cta-secondary"
            data-testid="cta-secondary"
          >
            Read the docs
          </button>
        </div>
      </section>
    </main>
  );
}
