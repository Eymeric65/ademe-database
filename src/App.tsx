/**
 * The shell. PR5 fills the header in with sign-in and the nav with real
 * entries; this is the harness's target, deliberately small.
 */
export default function App() {
  return (
    <>
      <header className="masthead">
        <h1>DPE</h1>
        <nav aria-label="Principal" />
      </header>
      <main>
        <p className="lede">
          Retrouvez un logement à partir des informations d’un diagnostic de performance
          énergétique.
        </p>
      </main>
    </>
  )
}
