-- Base autonome : aucune modification de ShopFlow.
CREATE ROLE atelier LOGIN PASSWORD 'atelier-local';
CREATE TABLE public.produits (id integer PRIMARY KEY, prix numeric(10,2) NOT NULL);
INSERT INTO public.produits SELECT n, 10 + n / 100.0 FROM generate_series(1,1000) AS n;
GRANT CONNECT ON DATABASE pooling TO atelier;
GRANT USAGE ON SCHEMA public TO atelier;
GRANT SELECT ON public.produits TO atelier;
ANALYZE public.produits;
