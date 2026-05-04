// SPDX-License-Identifier: Apache-2.0
//! Procedural macros for Foyer's capability registry.
//!
//! - `CapabilityRegistry` derive on an enum (variants use `#[capability("wire.id")]`).
//! - `cap_decl` attribute on functions or consts to mark code paths that depend on a wire id
//!   (no-op; useful for greps / future analysis).

use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, Data, DeriveInput, Expr, Lit, LitStr, Meta, MetaNameValue, Variant};

/// Attach to a `fn` or `const` to mark that a UI/backend code path depends on a
/// capability wire id. The attribute is a no-op at compile time; the canonical
/// list remains the `FoyerCapability` enum with `#[derive(CapabilityRegistry)]`.
/// Use this so greps and future static analysis can find capability consumers.
#[proc_macro_attribute]
pub fn cap_decl(attr: TokenStream, item: TokenStream) -> TokenStream {
    if let Err(e) = syn::parse::<LitStr>(attr) {
        return e.to_compile_error().into();
    }
    item
}

#[proc_macro_derive(CapabilityRegistry, attributes(capability, capability_registry))]
pub fn derive_capability_registry(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let enum_name = &input.ident;

    let mut registry_version: u32 = 1;
    for attr in &input.attrs {
        if attr.path().is_ident("capability_registry") {
            if let Err(e) = attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("version") {
                    let v: syn::LitInt = meta.value()?.parse()?;
                    registry_version = v.base10_parse()?;
                    Ok(())
                } else {
                    Err(meta.error("expected version = N"))
                }
            }) {
                return e.to_compile_error().into();
            }
        }
    }

    let Data::Enum(data_enum) = &input.data else {
        return syn::Error::new_spanned(
            &input.ident,
            "CapabilityRegistry can only be derived for enums",
        )
        .to_compile_error()
        .into();
    };

    let mut rows: Vec<(syn::Ident, String, Option<String>)> = Vec::new();

    for v in &data_enum.variants {
        let vident = &v.ident;
        let Some(wire) = parse_capability_wire_id(v) else {
            return syn::Error::new_spanned(
                vident,
                "missing #[capability(\"wire.id\")] on this variant",
            )
            .to_compile_error()
            .into();
        };
        let doc = extract_doc_comments(v);
        rows.push((vident.clone(), wire, doc));
    }

    // Stable order: sort by wire id for manifests and diffs.
    rows.sort_by(|a, b| a.1.cmp(&b.1));

    let variant_refs: Vec<_> = rows.iter().map(|(id, _, _)| id).collect();
    let wire_literals: Vec<_> = rows
        .iter()
        .map(|(_, w, _)| syn::LitStr::new(w, proc_macro2::Span::call_site()))
        .collect();

    let from_wire_blocks = rows.iter().map(|(vid, w, _)| {
        let lit = syn::LitStr::new(w, proc_macro2::Span::call_site());
        quote! {
            if s == #lit {
                return ::core::option::Option::Some(#enum_name::#vid);
            }
        }
    });
    let wire_self_arms = rows.iter().map(|(vid, w, _)| {
        let lit = syn::LitStr::new(w, proc_macro2::Span::call_site());
        quote! { #enum_name::#vid => #lit }
    });
    let desc_arms = rows.iter().map(|(vid, _, doc)| match &doc {
        Some(d) => {
            let lit = syn::LitStr::new(d, proc_macro2::Span::call_site());
            quote! { #enum_name::#vid => ::core::option::Option::Some(#lit) }
        }
        None => quote! { #enum_name::#vid => ::core::option::Option::None },
    });

    let n = variant_refs.len();
    let expanded = quote! {
        impl #enum_name {
            /// Bump when adding/removing/renaming wire ids (clients compare for drift).
            pub const REGISTRY_VERSION: u32 = #registry_version;

            /// Every capability variant (sorted by wire id).
            pub const ALL: [#enum_name; #n] = [#( #enum_name::#variant_refs ),*];

            /// Wire strings in sorted order (matches `ALL` order).
            pub const WIRE_IDS: [&'static str; #n] = [#( #wire_literals ),*];

            #[must_use]
            pub fn wire_id(self) -> &'static str {
                match self {
                    #( #wire_self_arms ,)*
                }
            }

            #[must_use]
            pub fn from_wire_id(s: &str) -> ::core::option::Option<Self> {
                #( #from_wire_blocks )*
                ::core::option::Option::None
            }

            /// Rustdoc-derived human text, when present.
            #[must_use]
            pub fn description(self) -> ::core::option::Option<&'static str> {
                match self {
                    #( #desc_arms ,)*
                }
            }
        }
    };

    TokenStream::from(expanded)
}

fn parse_capability_wire_id(v: &Variant) -> Option<String> {
    for attr in &v.attrs {
        if attr.path().is_ident("capability") {
            let s: syn::LitStr = attr.parse_args().ok()?;
            return Some(s.value());
        }
    }
    None
}

fn extract_doc_comments(v: &Variant) -> Option<String> {
    let mut parts = Vec::new();
    for attr in &v.attrs {
        if !attr.path().is_ident("doc") {
            continue;
        }
        let Meta::NameValue(MetaNameValue { value, .. }) = &attr.meta else {
            continue;
        };
        if let Expr::Lit(el) = value {
            if let Lit::Str(s) = &el.lit {
                let t = s.value().trim().to_string();
                if !t.is_empty() {
                    parts.push(t);
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}
